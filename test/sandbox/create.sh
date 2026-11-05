#!/usr/bin/env bash
# Builds Masna's private, disposable sandbox on GitHub, and clones it. It holds a
# small project, a hand-written .masna/ folder, labels, a milestone and three
# dependent issues. Rebuild it for each release: delete the old repo, then run this.
#
#   test/sandbox/create.sh <folder for the clone, not yet created> [owner/repo]
set -euo pipefail

target=${1:?folder for the clone, not yet created}
repo=${2:-ljkart/masna-sandbox}
here=$(cd "$(dirname "$0")" && pwd)
milestone='Reading list'

if [ -e "$target" ]; then
  echo "$target already exists" >&2
  exit 1
fi
if gh repo view "$repo" --json name > /dev/null 2>&1; then
  echo "$repo already exists. To rebuild it, delete it first: gh repo delete $repo" >&2
  exit 1
fi

# Sandbox commits use the same identity as this repo, which is a noreply address.
name=$(git -C "$here" config user.name)
email=$(git -C "$here" config user.email)

gh repo create "$repo" --private --description 'Disposable test project for Masna.' > /dev/null
gh repo clone "$repo" "$target" -- --quiet 2> /dev/null
cp -R "$here/project/." "$target/"

cd "$target"
git checkout --quiet -B main
git config user.name "$name"
git config user.email "$email"
git add -A
git commit --quiet -m 'Start the project'
git push --quiet -u origin main

gh label create ready-for-agent --color 0e8a16 --description 'Ready for Masna to work on' > /dev/null
gh label create masna:needs-human --color d93f0b --description 'Masna stopped: a person needs to look' > /dev/null
gh api 'repos/{owner}/{repo}/milestones' -f title="$milestone" --silent

create_issue() {
  gh issue create --title "$1" --body-file "$here/issues/$2.md" --label ready-for-agent --milestone "$milestone"
}
create_issue 'Parse reading-list lines' 1
create_issue 'List books from a reading list' 2
create_issue 'Add a reading-list page' 3

echo "Sandbox ready at $target"
