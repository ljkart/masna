#!/usr/bin/env bash
# Puts the sandbox back to the start, for another try at a run: no jobs, branches or
# PRs, every issue open with only the queue label, and no local changes. It discards
# all of that, so it only works on a clone of a repo named masna-sandbox.
#
#   test/sandbox/reset.sh <clone>
set -euo pipefail

cd "${1:?the sandbox clone}"
case "$(git remote get-url origin)" in
  *masna-sandbox*) ;;
  *) echo "$PWD isn't a clone of masna-sandbox" >&2; exit 1 ;;
esac

for number in $(gh pr list --state open --json number --jq '.[].number'); do
  gh pr close "$number" > /dev/null
done

git fetch --quiet --prune origin
for ref in $(git for-each-ref --format='%(refname:lstrip=3)' 'refs/remotes/origin/masna/'); do
  git push --quiet origin --delete "$ref"
done

rm -rf .masna/worktrees .masna/jobs .masna/run.json .masna/queue.json .masna/events*.jsonl
git worktree prune
git checkout --quiet main
git reset --quiet --hard origin/main
git clean -fdq
for ref in $(git for-each-ref --format='%(refname:lstrip=2)' 'refs/heads/masna/'); do
  git branch --quiet -D "$ref"
done
git stash clear

for number in $(gh issue list --state all --milestone 'Reading list' --json number --jq '.[].number'); do
  gh issue reopen "$number" > /dev/null 2>&1 || true
  gh issue edit "$number" --remove-label masna:needs-human > /dev/null 2>&1 || true
  # The engine won't post its verdicts again if it finds an earlier comment.
  for comment in $(gh api "repos/{owner}/{repo}/issues/$number/comments" --jq '.[].id'); do
    gh api -X DELETE "repos/{owner}/{repo}/issues/comments/$comment" --silent
  done
done

echo 'Sandbox reset'
