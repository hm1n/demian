"use client";

import { type FormEvent, useRef, useState } from "react";
import type { GitHubAuth } from "@/lib/github/types";
import { analyzeRepository, type AnalysisState, type LoadingPhase } from "./repository-analysis";
import styles from "./repository-analysis.module.css";

const INITIAL_STATE: AnalysisState = { status: "idle" };

interface RepositoryAnalysisViewProps {
  onContributionItemsSubmit?: (items: readonly string[]) => void;
}

function parseContributionItems(value: string) {
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

export function RepositoryAnalysisView({ onContributionItemsSubmit }: RepositoryAnalysisViewProps = {}) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [contributionItems, setContributionItems] = useState("");
  const [token, setToken] = useState("");
  const [state, setState] = useState<AnalysisState>(INITIAL_STATE);
  const ownerInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const loading = state.status === "loading";

  function startAnalysis(auth: GitHubAuth) {
    void analyzeRepository(auth, setState);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onContributionItemsSubmit?.(parseContributionItems(contributionItems));
    startAnalysis({ owner: owner.trim(), repo: repo.trim(), token });
  }

  function retry() {
    startAnalysis({ owner: owner.trim(), repo: repo.trim(), token });
  }

  function reauthenticate() {
    setToken("");
    setState(INITIAL_STATE);
    requestAnimationFrame(() => tokenInput.current?.focus());
  }

  function selectRepository() {
    setOwner("");
    setRepo("");
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
            <input ref={tokenInput} name="token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" disabled={loading} required />
            <span className={styles.hint}>토큰은 현재 조회 요청에만 사용하며 화면에 표시하지 않습니다.</span>
          </label>
          <button className={styles.button} type="submit" disabled={loading}>
            {loading ? "Repository 분석 중" : "Repository 분석 시작"}
          </button>
        </form>

        {state.status === "loading" ? <LoadingState loading={state.loading} /> : null}
        {state.status === "empty" ? <EmptyState kind={state.kind} onSelectRepository={selectRepository} /> : null}
        {state.status === "error" ? (
          <ErrorState error={state.error} onRetry={retry} onReauthenticate={reauthenticate} onSelectRepository={selectRepository} />
        ) : null}
        {state.status === "success" ? <SuccessState data={state.data} onSelectRepository={selectRepository} /> : null}
      </main>
    </div>
  );
}

function LoadingState({ loading }: { loading: LoadingPhase }) {
  const copy = loadingCopy(loading);
  const progress = loading.step === "details" && loading.total > 0 ? (loading.completed / loading.total) * 100 : null;
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

function EmptyState({ kind, onSelectRepository }: { kind: "no_commits" | "no_analyzable_commits"; onSelectRepository: () => void }) {
  const noCommits = kind === "no_commits";
  return (
    <section className={styles.state} aria-live="polite">
      <h2>{noCommits ? "분석할 커밋이 없습니다" : "이 저장소는 분석하기 어렵습니다"}</h2>
      <p>
        {noCommits
          ? "기본 브랜치에 커밋이 확인되지 않았습니다. 커밋 이력이 있는 Repository를 선택해 주세요."
          : "커밋은 있지만 병합, 문서, 의존성, 오타, 포맷팅 커밋을 제외하면 상세히 살펴볼 대상이 없습니다. 커밋 이력이 있는 다른 Repository를 선택해 주세요."}
      </p>
      <div className={styles.actions}>
        <button className={styles.secondaryButton} type="button" onClick={onSelectRepository}>다른 Repository 선택</button>
      </div>
    </section>
  );
}

interface ErrorStateProps {
  error: Extract<AnalysisState, { status: "error" }>["error"];
  onRetry: () => void;
  onReauthenticate: () => void;
  onSelectRepository: () => void;
}

function ErrorState({ error, onRetry, onReauthenticate, onSelectRepository }: ErrorStateProps) {
  const action = error.recovery === "reauthenticate"
    ? { label: "GitHub 인증 다시 하기", run: onReauthenticate }
    : error.recovery === "select_repository"
      ? { label: "Repository 다시 선택", run: onSelectRepository }
      : { label: "전체 조회 다시 시도", run: onRetry };
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

function SuccessState({ data, onSelectRepository }: { data: Extract<AnalysisState, { status: "success" }>["data"]; onSelectRepository: () => void }) {
  return (
    <section className={styles.state} aria-live="polite">
      <h2>Repository 근거를 준비했습니다</h2>
      <p>점수나 순위를 만들지 않고, 다음 단계에서 사용할 실제 Repository 데이터만 수집했습니다.</p>
      <div className={styles.summary}>
        <div className={styles.metric}><strong>{data.allCommits.length}</strong><span>전체 커밋</span></div>
        <div className={styles.metric}><strong>{data.includedCommits.length}</strong><span>상세 조회 커밋</span></div>
      </div>
      <div className={styles.actions}>
        <button className={styles.secondaryButton} type="button" onClick={onSelectRepository}>다른 Repository 선택</button>
      </div>
    </section>
  );
}
