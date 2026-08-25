import type { HighlighterCore } from "shiki/core";

/**
 * Syntax Highlighting을 담당합니다. 측정 결과(`wiki/2026-08-25-스트리밍-렌더링-측정과-전송-계약.md`)에
 * 따라 두 가지를 지킵니다.
 *
 * 첫째, highlighter 인스턴스를 모듈에 하나만 둡니다. 생성 비용이 최초 1회 50밀리초대이므로
 * 메시지마다 만들면 안 됩니다. 최초로 필요한 시점에 만들고 그 뒤에는 재사용합니다.
 *
 * 둘째, 필요한 테마와 언어만 등록합니다. `shiki`의 기본 번들은 모든 언어를 포함해서 크기가
 * 큽니다. `shiki/core`와 JavaScript 정규식 엔진을 쓰면 WASM 없이 동작하고 등록한 언어만
 * 들어갑니다.
 */
const THEME = "github-light";

/** 등록한 언어입니다. 여기 없는 언어는 highlight하지 않고 일반 텍스트로 보여 줍니다. */
const LANGUAGE_LOADERS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
} as const;

type SupportedLanguage = keyof typeof LANGUAGE_LOADERS;

const LANGUAGE_ALIASES: Readonly<Record<string, SupportedLanguage>> = {
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "tsx",
  tsx: "tsx",
  json: "json",
  css: "css",
  bash: "bash",
  sh: "bash",
  shell: "bash",
} as const;

export function resolveLanguage(language: string | undefined): SupportedLanguage | null {
  if (!language) return null;
  return LANGUAGE_ALIASES[language.toLowerCase()] ?? null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<SupportedLanguage>();

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light.mjs"),
      ]);
      return createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

/**
 * 코드를 highlight한 HTML을 돌려줍니다. 등록하지 않은 언어이거나 highlight에 실패하면 `null`을
 * 돌려주고, 호출부는 일반 텍스트로 보여 줍니다.
 */
export async function highlightCode(code: string, language: string | undefined): Promise<string | null> {
  const resolved = resolveLanguage(language);
  if (!resolved) return null;
  try {
    const highlighter = await getHighlighter();
    if (!loadedLanguages.has(resolved)) {
      await highlighter.loadLanguage((await LANGUAGE_LOADERS[resolved]()).default);
      loadedLanguages.add(resolved);
    }
    return highlighter.codeToHtml(code, { lang: resolved, theme: THEME });
  } catch {
    return null;
  }
}
