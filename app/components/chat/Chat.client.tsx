import { useStore } from '@nanostores/react';
import type { Message } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useMessageParser, usePromptEnhancer, useShortcuts } from '~/lib/hooks';
import { description, useChatHistory } from '~/lib/persistence';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore, CF_SERVER_JS } from '~/lib/stores/workbench';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from '@remix-run/react';
import { createSampler } from '~/utils/sampler';
import { getTemplates, selectStarterTemplate } from '~/utils/selectStarterTemplate';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils';
import { supabaseConnection } from '~/lib/stores/supabase';
import { defaultDesignScheme, type DesignScheme } from '~/types/design-scheme';
import type { ElementInfo } from '~/components/workbench/Inspector';
import type { TextUIPart, FileUIPart, Attachment } from '@ai-sdk/ui-utils';
import { useMCPStore } from '~/lib/stores/mcp';
import type { LlmErrorAlertType } from '~/types/actions';
import { tryTemplateRoute } from '~/lib/agents/templateRoute';
import { cfTrace } from '~/utils/cfTrace';
import { supabase } from '~/lib/supabaseClient';

const logger = createScopedLogger('Chat');

/* 사이드바 '답변 언어' (Menu.client 의 ANSWER_LANGS 와 같은 값) */
const CF_SPEC_MARKER = '<<coverfo-spec>>';
const ANSWER_LANG_NAMES: Record<string, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
  zh: '中文(简体)',
  th: 'ภาษาไทย',
};

function getAnswerLangInstruction(): string {
  try {
    const value = window.localStorage.getItem('cf-answer-lang') || 'auto';
    const name = ANSWER_LANG_NAMES[value];

    return name ? `[답변 언어] 설명과 답변은 반드시 ${name}(으)로 작성하세요.` : '';
  } catch {
    return '';
  }
}

/*
 * coverfo 요금 게이트 (2026-10-10 변경)
 *  크레딧 확인은 서버(/api/chat → app/lib/engine/chat-gate.ts)가 요청마다 직접 합니다.
 *   · chat(discuss, 글 답변) : 1회 0.2크레딧 (v210: 1크레딧 차감 → 답변 5회, 웹검색 비용 포함). 무료 크레딧(가입 4 = 20회)부터 쓰고, 다 쓰면 충전 크레딧
 *   · 앱 생성(build)         : 매번 크레딧 차감 (기본 8, Cloudflare 변수 COST_CHAT_BUILD)
 *  화면은 여기서 로그인만 확인합니다 (횟수를 화면에서도 세면 두 번 세지므로 세지 않음).
 */
async function cfChatGate(_mode: 'discuss' | 'build'): Promise<boolean> {
  let token = '';

  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token || '';
  } catch {
    token = '';
  }

  if (!token) {
    toast.info('로그인이 필요합니다.');
    return false;
  }

  return true;
}

/* coverfo: /api/chat 요청마다 최신 로그인 토큰을 붙입니다 (서버가 로그인·횟수·크레딧을 확인) */
const cfAuthFetch: typeof fetch = async (input, init) => {
  let token = '';

  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token || '';
  } catch {
    token = '';
  }

  const headers = new Headers(init?.headers || {});

  if (token) {
    headers.set('Authorization', 'Bearer ' + token);
  }

  return fetch(input, { ...init, headers });
};

/* coverfo: 서버가 막은 이유(로그인·크레딧)는 오류 상자 대신 안내 문구로 보여 줍니다. 처리했으면 true */
function cfGateNotice(e: any): boolean {
  let j: any = null;

  try {
    j = JSON.parse(String(e?.message || ''));
  } catch {
    return false;
  }

  if (!j || !j.code) {
    return false;
  }

  if (j.code === 'login') {
    toast.info(j.message || '로그인이 필요합니다.');
    return true;
  }

  if (j.code === 'insufficient') {
    toast.error(j.message || '크레딧이 부족합니다. 충전 후 이용해 주세요. (충전: /pricing)', { autoClose: 8000 });
    return true;
  }

  if (j.code === 'credit_error' || j.code === 'off') {
    toast.error(j.message || '잠시 후 다시 시도해 주세요.');
    return true;
  }

  return false;
}

/*
 * coverfo: 요금 결과 안내 (서버가 응답 머리말 X-CF-* 로 알려 줌) — v206
 *   · 무료 크레딧으로 처리: "무료 크레딧 1 사용 · 남은 무료 크레딧 N"
 *   · 무료 크레딧을 이번에 다 씀: "다음부터 충전 크레딧이 차감돼요" (새 가입자 기준 4번째 답)
 *   · 충전 크레딧으로 처리(5번째 답부터): "충전 크레딧 1 차감 · 남은 충전 크레딧 N"
 *   · 이달 무료 한도 소진·무료 기간 종료로 충전 크레딧이 쓰였으면 그 이유도 함께
 */
function cfChargeNotice(res: Response) {
  try {
    const h = (k: string) => res.headers.get(k);

    if (h('X-CF-Charged') === null) {
      return;
    }

    const usedFree = Number(h('X-CF-Used-Free') || '0');
    const usedPaid = Number(h('X-CF-Used-Paid') || '0');
    const free = Number(h('X-CF-Free') || '0');
    const paid = Number(h('X-CF-Paid') || '0');
    const note = h('X-CF-Note') || '';
    const packLeft = h('X-CF-Pack-Left');
    const packSize = Number(h('X-CF-Pack-Size') || '5');
    const packBought = h('X-CF-Pack-Bought') === '1';
    const why =
      note === 'pool_exhausted'
        ? ' (이번 달 무료 크레딧 한도가 다 차서 충전 크레딧에서 차감됐어요)'
        : note === 'free_closed'
          ? ' (무료 크레딧 제공 기간이 끝나 충전 크레딧에서 차감됐어요)'
          : '';

    // v210 글 답변 묶음 (1크레딧 = 답변 5회)
    if (packLeft !== null) {
      const left = Number(packLeft);

      if (packBought) {
        toast.info(
          (usedPaid > 0 ? `충전 크레딧 ${usedPaid}` : '무료 크레딧 1') +
            ` 사용 → chat 답변 ${packSize}회 (1회 ${Math.round(100 / packSize) / 100}크레딧) · 남은 답변 ${left}회 · ` +
            (usedPaid > 0 ? `남은 충전 크레딧 ${paid}` : `남은 무료 크레딧 ${free}`) +
            why,
          { autoClose: 5000 },
        );
      } else if (left === 0) {
        toast.info(`이번 ${packSize}회를 다 썼어요. 다음 답변에서 크레딧 1이 차감되고 다시 ${packSize}회를 씁니다.`, {
          autoClose: 5000,
        });
      }

      return;
    }

    if (usedPaid > 0) {
      toast.info(`충전 크레딧 ${usedPaid} 차감 · 남은 충전 크레딧 ${paid}${why}`, { autoClose: 4000 });
    } else if (usedFree > 0 && free <= 0) {
      toast.info('무료 크레딧을 모두 썼어요. 다음 답변부터는 충전 크레딧이 1회 1크레딧씩 차감돼요.', { autoClose: 6000 });
    } else if (usedFree > 0) {
      toast.info(`무료 크레딧 ${usedFree} 사용 · 남은 무료 크레딧 ${free}`, { autoClose: 3000 });
    }
  } catch {
    // 안내 실패는 무시
  }
}

export function Chat() {
  renderLogger.trace('Chat');

  const { ready, initialMessages, storeMessageHistory, importChat, exportChat } = useChatHistory();
  const title = useStore(description);

  /*
   * coverfo: 채팅은 로그인해야 쓸 수 있습니다.
   * 로그인 세션이 없으면 홈(/?login=1)으로 보내 로그인 창을 띄웁니다.
   * 홈 입력창에서 오든 /chat 링크로 직접 오든, 이 한 곳에서 모두 막힙니다.
   * 세션 확인에 실패하면(로그인 기능이 꺼져 있을 수 있음) 막지 않고 통과시킵니다.
   */
  const [gate, setGate] = useState<'checking' | 'allowed' | 'blocked'>('checking');
  useEffect(() => {
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!alive) {
          return;
        }

        if (data.session?.access_token) {
          setGate('allowed');
        } else {
          setGate('blocked');

          const back = window.location.pathname + window.location.search;
          window.location.replace('/?login=1&from=' + encodeURIComponent(back));
        }
      })
      .catch(() => {
        if (alive) {
          setGate('allowed');
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));
  }, [initialMessages]);

  if (gate !== 'allowed') {
    return null;
  }

  return (
    <>
      {ready && (
        <ChatImpl
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          importChat={importChat}
        />
      )}
    </>
  );
}

const processSampledMessages = createSampler(
  (options: {
    messages: Message[];
    initialMessages: Message[];
    isLoading: boolean;
    parseMessages: (messages: Message[], isLoading: boolean) => void;
    storeMessageHistory: (messages: Message[]) => Promise<void>;
  }) => {
    const { messages, initialMessages, isLoading, parseMessages, storeMessageHistory } = options;
    const last = messages[messages.length - 1];
    const size = typeof last?.content === 'string' ? last.content.length : 0;

    cfTrace('parse:start', size);
    parseMessages(messages, isLoading);
    cfTrace('parse:end', size);

    if (messages.length > initialMessages.length) {
      /*
       * coverfo: 답변이 오는 동안에는 대화 저장(브라우저 DB 에 대화 전체 + 파일 전체 스냅샷)을
       * 50ms 마다가 아니라 2초에 한 번만 합니다. 답변이 끝나면(isLoading=false) 반드시 한 번 더 저장합니다.
       */
      const now = Date.now();

      if (!isLoading || now - lastStoreAt >= STORE_INTERVAL_MS) {
        lastStoreAt = now;
        cfTrace('store:start', size);
        storeMessageHistory(messages)
          .then(() => cfTrace('store:end', size))
          .catch((error) => toast.error(error.message));
      }
    }
  },
  50,
);

const STORE_INTERVAL_MS = 2000;
let lastStoreAt = 0;

interface ChatProps {
  initialMessages: Message[];
  storeMessageHistory: (messages: Message[]) => Promise<void>;
  importChat: (description: string, messages: Message[]) => Promise<void>;
  exportChat: () => void;
  description?: string;
}

export const ChatImpl = memo(
  ({ description, initialMessages, storeMessageHistory, importChat, exportChat }: ChatProps) => {
    useShortcuts();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [imageDataList, setImageDataList] = useState<string[]>([]);
    const [searchParams, setSearchParams] = useSearchParams();
    const [fakeLoading, setFakeLoading] = useState(false);
    const files = useStore(workbenchStore.files);
    const [designScheme, setDesignScheme] = useState<DesignScheme>(defaultDesignScheme);
    const actionAlert = useStore(workbenchStore.alert);
    const deployAlert = useStore(workbenchStore.deployAlert);
    const supabaseConn = useStore(supabaseConnection);
    const selectedProject = supabaseConn.stats?.projects?.find(
      (project) => project.id === supabaseConn.selectedProjectId,
    );
    const supabaseAlert = useStore(workbenchStore.supabaseAlert);
    const { activeProviders, promptId, autoSelectTemplate, contextOptimizationEnabled } = useSettings();
    const [llmErrorAlert, setLlmErrorAlert] = useState<LlmErrorAlertType | undefined>(undefined);
    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || DEFAULT_MODEL;
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name === savedProvider) || DEFAULT_PROVIDER) as ProviderInfo;
    });
    const { showChat } = useStore(chatStore);
    const [animationScope, animate] = useAnimate();
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [chatMode, setChatMode] = useState<'discuss' | 'build'>(() => {
      // 홈화면 '무엇이든 물어보기' 버튼은 ?mode=discuss 로 들어옵니다 (파일 생성 없이 대화만)
      if (typeof window !== 'undefined') {
        const m = new URLSearchParams(window.location.search).get('mode');

        if (m === 'discuss') {
          return 'discuss';
        }
      }

      return 'build';
    });
    const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(null);
    const mcpSettings = useMCPStore((state) => state.settings);

    const {
      messages,
      isLoading,
      input,
      handleInputChange,
      setInput,
      stop,
      append,
      setMessages,
      reload,
      error,
      data: chatData,
      setData,
      addToolResult,
    } = useChat({
      api: '/api/chat',
      fetch: cfAuthFetch, // coverfo: 로그인 토큰을 붙여 보냄 (서버 요금 확인용)
      onResponse: (res) => cfChargeNotice(res), // coverfo: 무료 남은 횟수·크레딧 차감 안내
      body: {
        apiKeys,
        files,
        promptId,
        contextOptimization: contextOptimizationEnabled,
        chatMode,
        designScheme,
        supabase: {
          isConnected: supabaseConn.isConnected,
          hasSelectedProject: !!selectedProject,
          credentials: {
            supabaseUrl: supabaseConn?.credentials?.supabaseUrl,
            anonKey: supabaseConn?.credentials?.anonKey,
          },
        },
        maxLLMSteps: mcpSettings.maxLLMSteps,
      },
      sendExtraMessageFields: true,
      onError: (e) => {
        setFakeLoading(false);

        // coverfo: 서버가 로그인·크레딧 때문에 막은 경우는 안내 문구만
        if (cfGateNotice(e)) {
          stop();
          setData([]);

          return;
        }

        handleError(e, 'chat');
      },
      onFinish: (message, response) => {
        const usage = response.usage;
        setData(undefined);

        if (usage) {
          console.log('Token usage:', usage);
          logStore.logProvider('Chat response completed', {
            component: 'Chat',
            action: 'response',
            model,
            provider: provider.name,
            usage,
            messageLength: message.content.length,
          });
        }

        logger.debug('Finished streaming');

        /*
         * coverfo: AI 가 server.js·실행 단계 없이 끝냈어도 결과 화면이 뜨게 마무리합니다.
         * (마지막 단계 처리가 끝날 시간을 조금 준 뒤 실행)
         */
        if (chatMode === 'build') {
          setTimeout(() => workbenchStore.finishAndShowPreview({ openPreview: false }), 1500);
        }
      },
      initialMessages,
      initialInput: '', // 이전에 적었던 문구를 되살리지 않습니다 (쿠키 복원 끔)
    });
    useEffect(() => {
      const prompt = searchParams.get('prompt');

      // console.log(prompt, searchParams, model, provider);

      if (prompt) {
        const m = searchParams.get('mode');

        if (m === 'discuss' || m === 'build') {
          setChatMode(m);
        }

        setSearchParams({}, { replace: true });
        runAnimation();
        append({
          role: 'user',
          content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}`,
        });
      }
    }, [model, provider, searchParams]);

    /*
     * coverfo: 7단계 엔진(/engine)에서 넘어온 결과 HTML 을 워크벤치에 바로 띄웁니다.
     * 엔진 페이지가 sessionStorage 'cf-engine-result' 에 {title, html} 를 넣고 /chat?engine=1 로 옵니다.
     * 모델을 다시 부르지 않고, 스냅샷 복원과 같은 방식(숨은 메시지 + boltArtifact)으로 파일을 만들고 node server.js 를 실행합니다.
     */
    useEffect(() => {
      if (searchParams.get('engine') !== '1') {
        return;
      }

      let payload: { title?: string; html?: string; prompt?: string } | null = null;

      try {
        const raw = sessionStorage.getItem('cf-engine-result');
        sessionStorage.removeItem('cf-engine-result');
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }

      setSearchParams({}, { replace: true });

      if (!payload || !payload.html) {
        toast.error('엔진 결과를 찾지 못했습니다. /engine 에서 다시 실행해 주세요.');
        return;
      }

      const title = (payload.title || '엔진 결과').replace(/["<>]/g, '');
      const stamp = Date.now();

      setChatMode('build');
      runAnimation();
      setMessages([
        ...messages,
        {
          id: `engine-user-${stamp}`,
          role: 'user',
          content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${payload.prompt || title} (coverfo 엔진 결과 불러오기)`,
          annotations: ['hidden'],
        },
        {
          id: `engine-result-${stamp}`,
          role: 'assistant',
          content: `coverfo 엔진이 만든 결과를 화면에 띄웁니다. 고칠 점이 있으면 아래 입력칸에 적어 주세요.

<boltArtifact id="engine-result-${stamp}" title="${title}">
<boltAction type="file" filePath="index.html">
${payload.html}
</boltAction>
<boltAction type="file" filePath="server.js">
${CF_SERVER_JS}
</boltAction>
<boltAction type="start">
node server.js
</boltAction>
</boltArtifact>`,
        },
      ]);
    }, [searchParams]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 200 : 200;

    useEffect(() => {
      chatStore.setKey('started', initialMessages.length > 0);

      /*
       * coverfo: 목록에서 지난 대화를 다시 열면 ?mode= 가 없어 기본값 'build'(앱 생성)가 됩니다.
       * 그러면 글로만 묻던 대화(파리 볼 만한 곳…)에서 이어서 질문하고 Enter 를 누른 순간 앱 생성으로 넘어가
       * "앱을 만들고 있어요…" 카드가 떴습니다. 저장된 메시지에 앱 생성 흔적('[제작 지시]'·boltArtifact)이 하나도 없으면
       * 그 대화는 글 대화이므로 'discuss' 로 이어 갑니다. (주소에 ?mode= 가 있으면 그 값이 우선)
       */
      try {
        const urlMode = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mode') : null;

        if (!urlMode && initialMessages.length > 0) {
          const wasBuild = initialMessages.some((m) => {
            const c = typeof m.content === 'string' ? m.content : '';
            return c.includes('[제작 지시]') || c.includes('<boltArtifact');
          });

          if (!wasBuild) {
            setChatMode('discuss');
          }
        }
      } catch {
        // 판별이 안 되면 기본값 그대로
      }
    }, []);

    // 왼쪽 목록에서 지난 채팅을 열면 채팅 화면이 먼저 보이게 합니다.
    // (저장된 메시지를 다시 읽는 과정에서 결과·코드 화면이 자동으로 켜지는 것을 되돌림)
    useEffect(() => {
      if (initialMessages.length === 0) {
        return;
      }

      /*
       * 폰에서는 저장된 파일을 다시 푸는 데 1.2초보다 오래 걸려 그 뒤에 결과 화면이 켜지는 일이 있었습니다.
       * → 처음 4초 동안은 결과 화면이 켜지는 즉시 다시 끕니다 (그 뒤부터는 평소대로 열림).
       */
      const until = Date.now() + 4000;
      const unsub = workbenchStore.showWorkbench.subscribe((on) => {
        if (on && Date.now() < until) {
          workbenchStore.showWorkbench.set(false);
        }
      });
      const timers = [200, 600, 1200].map((ms) => setTimeout(() => workbenchStore.showWorkbench.set(false), ms));
      const stop = setTimeout(unsub, 4000);

      return () => {
        timers.forEach((t) => clearTimeout(t));
        clearTimeout(stop);
        unsub();
      };
    }, []);

    useEffect(() => {
      processSampledMessages({
        messages,
        initialMessages,
        isLoading,
        parseMessages,
        storeMessageHistory,
      });
    }, [messages, isLoading, parseMessages]);

    const scrollTextArea = () => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();

      logStore.logProvider('Chat response aborted', {
        component: 'Chat',
        action: 'abort',
        model,
        provider: provider.name,
      });
    };

    const handleError = useCallback(
      (error: any, context: 'chat' | 'template' | 'llmcall' = 'chat') => {
        logger.error(`${context} request failed`, error);

        stop();
        setFakeLoading(false);

        // coverfo: 오류로 끊겨도 만들어진 데까지 결과 화면을 보여 줍니다
        workbenchStore.abortAllActions();

        let errorInfo = {
          message: 'An unexpected error occurred',
          isRetryable: true,
          statusCode: 500,
          provider: provider.name,
          type: 'unknown' as const,
          retryDelay: 0,
        };

        if (error.message) {
          try {
            const parsed = JSON.parse(error.message);

            if (parsed.error || parsed.message) {
              errorInfo = { ...errorInfo, ...parsed };
            } else {
              errorInfo.message = error.message;
            }
          } catch {
            errorInfo.message = error.message;
          }
        }

        let errorType: LlmErrorAlertType['errorType'] = 'unknown';
        let title = 'Request Failed';

        if (errorInfo.statusCode === 401 || errorInfo.message.toLowerCase().includes('api key')) {
          errorType = 'authentication';
          title = 'Authentication Error';
        } else if (errorInfo.statusCode === 429 || errorInfo.message.toLowerCase().includes('rate limit')) {
          errorType = 'rate_limit';
          title = 'Rate Limit Exceeded';
        } else if (errorInfo.message.toLowerCase().includes('quota')) {
          errorType = 'quota';
          title = 'Quota Exceeded';
        } else if (errorInfo.statusCode >= 500) {
          errorType = 'network';
          title = 'Server Error';
        }

        logStore.logError(`${context} request failed`, error, {
          component: 'Chat',
          action: 'request',
          error: errorInfo.message,
          context,
          retryable: errorInfo.isRetryable,
          errorType,
          provider: provider.name,
        });

        // Create API error alert
        setLlmErrorAlert({
          type: 'error',
          title,
          description: errorInfo.message,
          provider: provider.name,
          errorType,
        });
        setData([]);
      },
      [provider.name, stop],
    );

    const clearApiErrorAlert = useCallback(() => {
      setLlmErrorAlert(undefined);
    }, []);

    useEffect(() => {
      const textarea = textareaRef.current;

      if (textarea) {
        textarea.style.height = 'auto';

        const scrollHeight = textarea.scrollHeight;

        textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
        textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
      }
    }, [input, textareaRef]);

    const runAnimation = async () => {
      if (chatStarted) {
        return;
      }

      await Promise.all([
        animate('#examples', { opacity: 0, display: 'none' }, { duration: 0.1 }),
        animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
      ]);

      chatStore.setKey('started', true);

      setChatStarted(true);
    };

    // Helper function to create message parts array from text and images
    const createMessageParts = (text: string, images: string[] = []): Array<TextUIPart | FileUIPart> => {
      // Create an array of properly typed message parts
      const parts: Array<TextUIPart | FileUIPart> = [
        {
          type: 'text',
          text,
        },
      ];

      // Add image parts if any
      images.forEach((imageData) => {
        // Extract correct MIME type from the data URL
        const mimeType = imageData.split(';')[0].split(':')[1] || 'image/jpeg';

        // Create file part according to AI SDK format
        parts.push({
          type: 'file',
          mimeType,
          data: imageData.replace(/^data:image\/[^;]+;base64,/, ''),
        });
      });

      return parts;
    };

    // Helper function to convert File[] to Attachment[] for AI SDK
    const filesToAttachments = async (files: File[]): Promise<Attachment[] | undefined> => {
      if (files.length === 0) {
        return undefined;
      }

      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<Attachment>((resolve) => {
              const reader = new FileReader();

              reader.onloadend = () => {
                resolve({
                  name: file.name,
                  contentType: file.type,
                  url: reader.result as string,
                });
              };
              reader.readAsDataURL(file);
            }),
        ),
      );

      return attachments;
    };

    const sendMessage = async (_event: React.UIEvent, messageInput?: string) => {
      const messageContent = messageInput || input;

      if (!messageContent?.trim()) {
        return;
      }

      if (isLoading) {
        abort();
        return;
      }

      /*
       * coverfo: 이번 전송이 '앱 생성(build)'인지 '글 답변(discuss)'인지를 메시지 내용으로 판별합니다.
       *  - chat 버튼: 원문 그대로 보냄(제작 지시 없음) → discuss
       *  - 앱 생성 버튼/build 엔터: buildSpec 이 '[제작 지시]' 문구를 붙여 보냄 → build
       * chatMode 상태값은 버튼을 누른 직후엔 아직 안 바뀌어 있어(리액트 상태 반영 지연) 그대로 쓰면
       * 직전 모드로 잘못 전송됩니다(=chat 눌러도 앱 생성됨). 그래서 내용으로 판별합니다.
       */
      const effectiveMode: 'discuss' | 'build' = messageContent.includes('[제작 지시]') ? 'build' : 'discuss';

      /*
       * coverfo 모델 분리: 일반 문의(discuss)는 저가 모델(gpt-6-luna)로 강제, 앱 생성(build)은 사용자가 고른 모델 그대로.
       * 서버(api.chat)는 메시지 앞의 [Model:]/[Provider:] 로 모델을 정하므로, 여기서 접두어만 바꾸면 됩니다.
       * (엔진·3D·스튜디오는 이 흐름과 무관 — 서버 지정 그대로)
       */
      const cfSendModel = effectiveMode === 'discuss' ? 'gpt-6-luna' : model;
      const cfSendProvider = effectiveMode === 'discuss' ? 'OpenAI' : provider.name;
      const cfPrefix = `[Model: ${cfSendModel}]\n\n[Provider: ${cfSendProvider}]\n\n`;

      /*
       * 새로 요청을 보내면 이전 오류 안내는 지웁니다.
       * 다시 만들었는데도 빨간 오류가 남아 있으면 사용자가 실패한 줄 알게 됩니다.
       */
      workbenchStore.clearAlert();
      workbenchStore.clearSupabaseAlert();
      workbenchStore.clearDeployAlert();

      // coverfo: 첫 메시지가 템플릿이 있는 요청(예: 예약 페이지)이면 AI 대신 템플릿으로 바로 만들지 물어봄
      if (!chatStarted && effectiveMode === 'build' && uploadedFiles.length === 0 && imageDataList.length === 0) {
        const handledByTemplate = await tryTemplateRoute(messageContent, importChat);

        if (handledByTemplate) {
          return;
        }
      }

      // coverfo: 로그인만 확인 (무료 횟수·크레딧은 서버 /api/chat 이 직접 확인)
      const allowedToSend = await cfChatGate(effectiveMode);

      if (!allowedToSend) {
        return;
      }

      let finalMessageContent = messageContent;

      if (selectedElement) {
        console.log('Selected Element:', selectedElement);

        const elementInfo = `<div class=\"__boltSelectedElement__\" data-element='${JSON.stringify(selectedElement)}'>${JSON.stringify(`${selectedElement.displayText}`)}</div>`;
        finalMessageContent = messageContent + elementInfo;
      }

      /* 사이드바 '답변 언어' 설정: 화면에 안 보이는 지시문 부분에 답변 언어를 붙입니다 */
      const answerLangInstruction = getAnswerLangInstruction();

      if (answerLangInstruction) {
        finalMessageContent += finalMessageContent.includes(CF_SPEC_MARKER)
          ? `\n${answerLangInstruction}`
          : `\n\n${CF_SPEC_MARKER}\n${answerLangInstruction}`;
      }

      runAnimation();

      if (!chatStarted) {
        setFakeLoading(true);

        // 일반 문의(discuss)는 앱 뼈대(스타터 템플릿)를 만들지 않습니다. 앱 생성(build)일 때만.
        if (autoSelectTemplate && effectiveMode === 'build') {
          const { template, title } = await selectStarterTemplate({
            message: finalMessageContent,
            model,
            provider,
          });

          if (template !== 'blank') {
            const temResp = await getTemplates(template, title).catch((e) => {
              if (e.message.includes('rate limit')) {
                toast.warning('Rate limit exceeded. Skipping starter template\n Continuing with blank template');
              } else {
                toast.warning('Failed to import starter template\n Continuing with blank template');
              }

              return null;
            });

            if (temResp) {
              const { assistantMessage, userMessage } = temResp;
              const userMessageText = `${cfPrefix}${finalMessageContent}`;

              setMessages([
                {
                  id: `1-${new Date().getTime()}`,
                  role: 'user',
                  content: userMessageText,
                  parts: createMessageParts(userMessageText, imageDataList),
                },
                {
                  id: `2-${new Date().getTime()}`,
                  role: 'assistant',
                  content: assistantMessage,
                },
                {
                  id: `3-${new Date().getTime()}`,
                  role: 'user',
                  content: `${cfPrefix}${userMessage}`,
                  annotations: ['hidden'],
                },
              ]);

              const reloadOptions: any = { body: { chatMode: effectiveMode } };

              if (uploadedFiles.length > 0) {
                reloadOptions.experimental_attachments = await filesToAttachments(uploadedFiles);
              }

              reload(reloadOptions);
              setInput('');
              Cookies.remove(PROMPT_COOKIE_KEY);

              setUploadedFiles([]);
              setImageDataList([]);

              resetEnhancer();

              textareaRef.current?.blur();
              setFakeLoading(false);

              return;
            }
          }
        }

        // If autoSelectTemplate is disabled or template selection failed, proceed with normal message
        const userMessageText = `${cfPrefix}${finalMessageContent}`;
        const attachments = uploadedFiles.length > 0 ? await filesToAttachments(uploadedFiles) : undefined;

        setMessages([
          {
            id: `${new Date().getTime()}`,
            role: 'user',
            content: userMessageText,
            parts: createMessageParts(userMessageText, imageDataList),
            experimental_attachments: attachments,
          },
        ]);

        const firstReloadOptions: any = { body: { chatMode: effectiveMode } };

        if (attachments) {
          firstReloadOptions.experimental_attachments = attachments;
        }

        reload(firstReloadOptions);
        setFakeLoading(false);
        setInput('');
        Cookies.remove(PROMPT_COOKIE_KEY);

        setUploadedFiles([]);
        setImageDataList([]);

        resetEnhancer();

        textareaRef.current?.blur();

        return;
      }

      if (error != null) {
        setMessages(messages.slice(0, -1));
      }

      const modifiedFiles = workbenchStore.getModifiedFiles();

      chatStore.setKey('aborted', false);

      if (modifiedFiles !== undefined) {
        const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
        const messageText = `${cfPrefix}${userUpdateArtifact}${finalMessageContent}`;

        const attachmentOptions: any = { body: { chatMode: effectiveMode } };

        if (uploadedFiles.length > 0) {
          attachmentOptions.experimental_attachments = await filesToAttachments(uploadedFiles);
        }

        append(
          {
            role: 'user',
            content: messageText,
            parts: createMessageParts(messageText, imageDataList),
          },
          attachmentOptions,
        );

        workbenchStore.resetAllFileModifications();
      } else {
        const messageText = `${cfPrefix}${finalMessageContent}`;

        const attachmentOptions: any = { body: { chatMode: effectiveMode } };

        if (uploadedFiles.length > 0) {
          attachmentOptions.experimental_attachments = await filesToAttachments(uploadedFiles);
        }

        append(
          {
            role: 'user',
            content: messageText,
            parts: createMessageParts(messageText, imageDataList),
          },
          attachmentOptions,
        );
      }

      setInput('');
      Cookies.remove(PROMPT_COOKIE_KEY);

      setUploadedFiles([]);
      setImageDataList([]);

      resetEnhancer();

      textareaRef.current?.blur();
    };

    /**
     * Handles the change event for the textarea and updates the input state.
     * @param event - The change event from the textarea.
     */
    const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleInputChange(event);
    };

    /**
     * Debounced function to cache the prompt in cookies.
     * Caches the trimmed value of the textarea input after a delay to optimize performance.
     */
    const debouncedCachePrompt = useCallback(
      debounce((event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const trimmedValue = event.target.value.trim();
        Cookies.set(PROMPT_COOKIE_KEY, trimmedValue, { expires: 30 });
      }, 1000),
      [],
    );

    useEffect(() => {
      const storedApiKeys = Cookies.get('apiKeys');

      if (storedApiKeys) {
        setApiKeys(JSON.parse(storedApiKeys));
      }
    }, []);

    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      Cookies.set('selectedModel', newModel, { expires: 30 });
    };

    const handleProviderChange = (newProvider: ProviderInfo) => {
      setProvider(newProvider);
      Cookies.set('selectedProvider', newProvider.name, { expires: 30 });
    };

    const handleWebSearchResult = useCallback(
      (result: string) => {
        const currentInput = input || '';
        const newInput = currentInput.length > 0 ? `${result}\n\n${currentInput}` : result;

        // Update the input via the same mechanism as handleInputChange
        const syntheticEvent = {
          target: { value: newInput },
        } as React.ChangeEvent<HTMLTextAreaElement>;
        handleInputChange(syntheticEvent);
      },
      [input, handleInputChange],
    );

    return (
      <BaseChat
        ref={animationScope}
        textareaRef={textareaRef}
        input={input}
        showChat={showChat}
        chatStarted={chatStarted}
        isStreaming={isLoading || fakeLoading}
        onStreamingChange={(streaming) => {
          streamingState.set(streaming);
        }}
        enhancingPrompt={enhancingPrompt}
        promptEnhanced={promptEnhanced}
        sendMessage={sendMessage}
        model={model}
        setModel={handleModelChange}
        provider={provider}
        setProvider={handleProviderChange}
        providerList={activeProviders}
        handleInputChange={(e) => {
          onTextareaChange(e);
          debouncedCachePrompt(e);
        }}
        handleStop={abort}
        description={description}
        importChat={importChat}
        exportChat={exportChat}
        messages={messages.map((message, i) => {
          if (message.role === 'user') {
            return message;
          }

          return {
            ...message,
            content: parsedMessages[i] || '',
          };
        })}
        enhancePrompt={() => {
          enhancePrompt(
            input,
            (input) => {
              setInput(input);
              scrollTextArea();
            },
            model,
            provider,
            apiKeys,
          );
        }}
        uploadedFiles={uploadedFiles}
        setUploadedFiles={setUploadedFiles}
        imageDataList={imageDataList}
        setImageDataList={setImageDataList}
        actionAlert={actionAlert}
        clearAlert={() => workbenchStore.clearAlert()}
        supabaseAlert={supabaseAlert}
        clearSupabaseAlert={() => workbenchStore.clearSupabaseAlert()}
        deployAlert={deployAlert}
        clearDeployAlert={() => workbenchStore.clearDeployAlert()}
        llmErrorAlert={llmErrorAlert}
        clearLlmErrorAlert={clearApiErrorAlert}
        data={chatData}
        chatMode={chatMode}
        setChatMode={setChatMode}
        append={append}
        designScheme={designScheme}
        setDesignScheme={setDesignScheme}
        selectedElement={selectedElement}
        setSelectedElement={setSelectedElement}
        addToolResult={addToolResult}
        onWebSearchResult={handleWebSearchResult}
      />
    );
  },
);
