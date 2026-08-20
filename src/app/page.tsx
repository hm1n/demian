import { RepositoryAnalysisView } from "@/features/repository-analysis/repository-analysis-view";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <RepositoryAnalysisView />
    </div>
  );
}
