import { RepositoryAnalysisView } from "@/features/repository-analysis/repository-analysis-view";
import { GITHUB_SESSION_COOKIE } from "@/lib/github/auth-session";
import { cookies } from "next/headers";
import styles from "./page.module.css";

export default async function Home({ searchParams }: { searchParams: Promise<{ auth_error?: string | string[] }> }) {
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const authError = Array.isArray(params.auth_error) ? params.auth_error[0] : params.auth_error;

  return (
    <div className={styles.page}>
      <RepositoryAnalysisView hasSession={cookieStore.has(GITHUB_SESSION_COOKIE)} authError={authError} />
    </div>
  );
}
