// GITHUB_TOKEN=$(gh auth token) npx tsx scripts/manual-test-commits.ts <owner> <repo> [--blacklist]
import { classifyBlacklistedCommit, type CommitBlacklistCategory } from "../src/lib/github/commit-blacklist";
import { fetchAllCommits } from "../src/lib/github/commits";

const [owner, repo, ...options] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;

if (!owner || !repo || !token) {
  console.log("owner, repo, GITHUB_TOKEN이 필요합니다.");
  process.exitCode = 1;
} else {
  const commits = await fetchAllCommits({ owner, repo, token });

  if (!options.includes("--blacklist")) {
    console.log(JSON.stringify(commits, null, 2));
  } else {
    const counts: Record<CommitBlacklistCategory, number> = {
      merge: 0,
      documentation: 0,
      dependency: 0,
      typo: 0,
      formatting: 0,
    };
    const excluded = commits.flatMap((commit) => {
      const category = classifyBlacklistedCommit(commit);
      if (category === null) return [];
      counts[category]++;
      return [{ category, title: commit.title }];
    });

    console.log(JSON.stringify({ total: commits.length, counts, excluded }, null, 2));
  }
}
