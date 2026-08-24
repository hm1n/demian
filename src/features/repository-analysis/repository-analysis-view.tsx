"use client";

import { type FormEvent, useRef, useState } from "react";
import type { RepositoryRef } from "@/lib/github/types";
import { ExperienceCandidateList } from "@/features/experience-candidates/experience-candidate-list";
import {
  analyzeRepository,
  generateCandidates,
  type AnalysisState,
  type EmptyKind,
  type LoadingPhase,
} from "./repository-analysis";
import styles from "./repository-analysis.module.css";

const INITIAL_STATE: AnalysisState = { status: "idle" };

// ponytail: 줄바꿈을 항목 경계로 고정합니다. 항목 안에 여러 줄 설명이 필요해질 때 구조화 입력으로 승격합니다.
export function parseContributionItems(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function loadingCopy(loading: LoadingPhase) {
  if (loading.step === "commits") {
    return {
      step: "1단계",
      title: "전체 커밋을 조회하고 있습니다",
      description: "기본 브랜치의 커밋을 빠짐없이 확인합니다. 커밋 수에는 임의의 상한을 두지 않습니다.",
    };
  }
  if (loading.step === "deriving") {
    return {
      step: "3단계",
      title: "파생 지표를 계산하고 있습니다",
      description: "수집한 Repository 근거를 후보 데이터 입력 형태로 정리하고 있습니다.",
    };
  }
  if (loading.step === "stage_a") {
    return {
      step: "4단계",
      title: "경험 후보를 1차 선별하고 있습니다",
      description: loading.waitingForRateLimit
        ? `${loading.total}개 중 ${loading.completed}개를 판단했습니다. 다음 청크를 위해 LLM 토큰 한도 초기화를 기다리고 있습니다.`
        : `${loading.total}개 중 ${loading.completed}개를 판단했고 ${loading.total - loading.completed}개가 남았습니다.`,
    };
  }
  if (loading.step === "stage_b") {
    return {
      step: "5·6단계",
      title: "diff·PR 근거를 수집하고 최종 후보를 판단하고 있습니다",
      description:
        "서버가 후보 커밋의 diff와 PR 소속을 수집한 뒤 한 번의 판단으로 최대 3개 후보를 고릅니다. 두 단계는 한 요청으로 처리됩니다.",
    };
  }
  return {
    step: "2단계",
    title:
      loading.phase === "repository_metadata"
        ? "Repository 정보를 조회하고 있습니다"
        : "분석할 커밋의 상세 정보를 조회하고 있습니다",
    description:
      loading.phase === "repository_metadata"
        ? "커밋 상세 조회를 마치고 파일 트리와 언어 통계를 확인하고 있습니다."
        : `${loading.total}개 중 ${loading.completed}개를 확인했습니다.`,
  };
}

export function RepositoryAnalysisView() {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [contributionItems, setContributionItems] = useState("");
  const [token, setToken] = useState("");
  const [hasSession, setHasSession] = useState(false);
  const [state, setState] = useState<AnalysisState>(INITIAL_STATE);
  const ownerInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const loading = state.status === "loading";

  async function startAnalysis(repository: RepositoryRef, newToken: string) {
    setState({ status: "loading", loading: { step: "commits" } });
    let response: Response;
    try {
      response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: newToken }),
      });
    } catch {
      setState({
        status: "error",
        error: {
          kind: "network",
          title: "GitHub 인증 세션에 연결하지 못했습니다",
          message: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
          recovery: "retry",
        },
      });
      return;
    }
    if (!response.ok) {
      setState({
        status: "error",
        error: {
          kind: "server_error",
          title: "GitHub 인증 세션을 만들지 못했습니다",
          message: "잠시 후 다시 시도해 주세요.",
          recovery: "retry",
        },
      });
      return;
    }
    setHasSession(true);
    setToken("");
    await analyzeRepository(repository, parseContributionItems(contributionItems), setState);
  }

  function runAnalysis() {
    const repository = { owner: owner.trim(), repo: repo.trim() };
    if (token) return startAnalysis(repository, token);
    if (hasSession) return analyzeRepository(repository, parseContributionItems(contributionItems), setState);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runAnalysis();
  }

  function retry() {
    if (state.status === "error" && state.retryPoint) return generateCandidates(state.retryPoint, setState);
    runAnalysis();
  }

  async function reauthenticate() {
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
    setHasSession(false);
    setToken("");
    setState(INITIAL_STATE);
    requestAnimationFrame(() => tokenInput.current?.focus());
  }

  function selectRepository() {
    setOwner("");
    setRepo("");
    setContributionItems("");
    setState(INITIAL_STATE);
    requestAnimationFrame(() => ownerInput.current?.focus());
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Repository analysis</p>
        <h1>코드에 남은 개발 경험을 찾아보세요</h1>
        <p>GitHub Repository의 실제 커밋과 파일을 조회해 인터뷰에 사용할 근거를 준비합니다.</p>
      </header>

      <main className={styles.card}>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.repositoryFields}>
            <label className={styles.field}>
              Owner
              <input ref={ownerInput} name="owner" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="octocat" autoComplete="off" disabled={loading} required />
            </label>
            <label className={styles.field}>
              Repository
              <input name="repository" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="hello-world" autoComplete="off" disabled={loading} required />
            </label>
          </div>
          <label className={styles.field}>
            본인 기여 항목 (선택)
            <textarea name="contributionItems" value={contributionItems} onChange={(event) => setContributionItems(event.target.value)} placeholder={"푸시 알림 구현\n게시판 기능 구현"} autoComplete="off" disabled={loading} rows={4} />
            <span className={styles.hint}>기억나는 기여를 한 줄에 하나씩 입력해 주세요. 비워두면 Repository 근거만으로 경험 후보를 찾습니다.</span>
          </label>
          <label className={styles.field}>
            GitHub token
            <input ref={tokenInput} name="token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" disabled={loading} required={!hasSession} />
            <span className={styles.hint}>토큰은 암호화된 보안 쿠키에 저장하며 화면에 표시하지 않습니다.</span>
          </label>
          <button className={styles.button} type="submit" disabled={loading}>
            {loading ? "Repository 분석 중" : "Repository 분석 시작"}
          </button>
        </form>

        {state.status === "loading" ? <LoadingState loading={state.loading} /> : null}
        {state.status === "empty" ? (
          <EmptyState
            kind={state.kind}
            reason={state.kind === "no_final_candidates" ? state.reason : undefined}
            onSelectRepository={selectRepository}
          />
        ) : null}
        {state.status === "error" ? (
          <ErrorState
            error={state.error}
            retryLabel={state.retryPoint ? "후보 생성 다시 시도" : "전체 조회 다시 시도"}
            onRetry={retry}
            onReauthenticate={reauthenticate}
            onSelectRepository={selectRepository}
          />
        ) : null}
        {state.status === "success" ? (
          <ExperienceCandidateList data={state.data} candidates={state.candidates} onSelectRepository={selectRepository} />
        ) : null}
      </main>
    </div>
  );
}

function LoadingState({ loading }: { loading: LoadingPhase }) {
  const copy = loadingCopy(loading);
  const progress = (loading.step === "details" || loading.step === "stage_a") && loading.total > 0
    ? (loading.completed / loading.total) * 100
    : null;
  return (
    <section className={styles.state} role="status" aria-live="polite">
      <span className={styles.step}>{copy.step}</span>
      <h2>{copy.title}</h2>
      <p>{copy.description}</p>
      <div className={styles.progressTrack} aria-hidden="true">
        <div className={`${styles.progressBar} ${progress === null ? styles.indeterminate : ""}`} style={progress === null ? undefined : { width: `${progress}%` }} />
      </div>
    </section>
  );
}

const EMPTY_COPY: Record<EmptyKind | "no_final_candidates", { title: string; description: string }> = {
  no_commits: {
    title: "분석할 커밋이 없습니다",
    description: "기본 브랜치에 커밋이 확인되지 않았습니다. 커밋 이력이 있는 Repository를 선택해 주세요.",
  },
  no_author_commits: {
    title: "본인이 작성한 커밋이 없습니다",
    description:
      "기본 브랜치에는 커밋이 있지만 현재 GitHub 계정이 작성자로 연결된 커밋은 확인되지 않았습니다. 본인이 작성한 커밋이 있는 다른 Repository를 선택해 주세요.",
  },
  no_analyzable_commits: {
    title: "이 저장소는 분석하기 어렵습니다",
    description:
      "커밋은 있지만 병합, 문서, 의존성, 오타, 포맷팅 커밋을 제외하면 상세히 살펴볼 대상이 없습니다. 커밋 이력이 있는 다른 Repository를 선택해 주세요.",
  },
  no_stage_a_candidates: {
    title: "설명할 만한 경험 후보를 찾지 못했습니다",
    description:
      "커밋 메시지와 변경 통계에서 기여 항목과 일치하거나 설명할 가치가 있는 커밋을 찾지 못했습니다. 다른 Repository를 선택해 주세요.",
  },
  no_final_candidates: {
    title: "최종 경험 후보를 만들지 못했습니다",
    description: "기준을 완화하거나 후보를 임의로 채우지 않습니다. 다른 Repository를 선택해 주세요.",
  },
};

function EmptyState({
  kind,
  reason,
  onSelectRepository,
}: {
  kind: EmptyKind | "no_final_candidates";
  reason?: string;
  onSelectRepository: () => void;
}) {
  const copy = EMPTY_COPY[kind];
  return (
    <section className={styles.state} aria-live="polite" data-empty-kind={kind}>
      <h2>{copy.title}</h2>
      {reason ? <p>{reason}</p> : null}
      <p>{copy.description}</p>
      <div className={styles.actions}>
        <button className={styles.secondaryButton} type="button" onClick={onSelectRepository}>다른 Repository 선택</button>
      </div>
    </section>
  );
}

interface ErrorStateProps {
  error: Extract<AnalysisState, { status: "error" }>["error"];
  retryLabel: string;
  onRetry: () => void;
  onReauthenticate: () => void;
  onSelectRepository: () => void;
}

function ErrorState({ error, retryLabel, onRetry, onReauthenticate, onSelectRepository }: ErrorStateProps) {
  const action = error.recovery === "reauthenticate"
    ? { label: "GitHub 인증 다시 하기", run: onReauthenticate }
    : error.recovery === "select_repository"
      ? { label: "Repository 다시 선택", run: onSelectRepository }
      : { label: retryLabel, run: onRetry };
  return (
    <section className={styles.state} role="alert" data-error-kind={error.kind}>
      <h2>{error.title}</h2>
      <p>{error.message}</p>
      <div className={styles.actions}>
        <button className={styles.button} type="button" onClick={action.run}>{action.label}</button>
      </div>
    </section>
  );
}

