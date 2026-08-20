import { filterCommitsForDetail } from "./commit-blacklist";
import { fetchRepositoryContributionData } from "./contributions";
import type {
  CandidateDataInput,
  CandidateDataOutput,
  CommitSummary,
  ContributionFetchProgress,
  GitHubAuth,
} from "./types";

/**
 * 앞 단계가 이미 수집하거나 계산한 값만 후보 생성 기능의 입력 형태로 조립합니다.
 * 이 함수는 GitHub API 호출, 후보 평가, 점수 계산, 순위 결정 또는 후보 선별을 하지 않습니다.
 */
export function buildCandidateData(
  ...[allCommits, contributionData]: CandidateDataInput
): CandidateDataOutput {
  return {
    allCommits,
    includedCommits: contributionData.commits,
    repository: {
      fileTree: contributionData.tree,
      treeTruncated: contributionData.treeTruncated,
      languages: contributionData.languages,
    },
  };
}

/** 기존 블랙리스트와 상세 조회 결과를 후보 생성 기능의 입력까지 연결합니다. */
export async function fetchCandidateData(
  auth: GitHubAuth,
  allCommits: readonly CommitSummary[],
  onProgress?: (progress: ContributionFetchProgress) => void
): Promise<CandidateDataOutput> {
  const includedCommits = filterCommitsForDetail(allCommits);
  const contributionData = await fetchRepositoryContributionData(
    auth,
    includedCommits,
    onProgress
  );
  return buildCandidateData(allCommits, contributionData);
}
