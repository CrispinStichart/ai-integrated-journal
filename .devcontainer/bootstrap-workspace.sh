#!/usr/bin/env bash

set -Eeuo pipefail

readonly WORKSPACE_DIR="/workspaces/ai-integrated-journal"
readonly HOST_SSH_DIR="/mnt/host-ssh"
readonly DEV_USER="pwuser"
readonly EXPECTED_ORIGIN="git@github.com:CrispinStichart/ai-integrated-journal.git"

fail() {
  printf 'Devcontainer bootstrap failed: %s\n' "$*" >&2
  exit 1
}

if [[ ${EUID} -ne 0 ]]; then
  fail "this script must run as root"
fi

DEV_HOME="$(getent passwd "${DEV_USER}" | cut -d: -f6)"
readonly DEV_HOME
[[ -n ${DEV_HOME} ]] || fail "user ${DEV_USER} does not exist"

for required_file in id_ed25519 id_ed25519.pub known_hosts; do
  [[ -f "${HOST_SSH_DIR}/${required_file}" ]] ||
    fail "required Windows SSH file is missing: ${HOST_SSH_DIR}/${required_file}"
done

install -d -m 0700 -o "${DEV_USER}" -g "${DEV_USER}" "${DEV_HOME}/.ssh"
install -m 0600 -o "${DEV_USER}" -g "${DEV_USER}" \
  "${HOST_SSH_DIR}/id_ed25519" "${DEV_HOME}/.ssh/id_ed25519"
install -m 0644 -o "${DEV_USER}" -g "${DEV_USER}" \
  "${HOST_SSH_DIR}/id_ed25519.pub" "${DEV_HOME}/.ssh/id_ed25519.pub"
install -m 0644 -o "${DEV_USER}" -g "${DEV_USER}" \
  "${HOST_SSH_DIR}/known_hosts" "${DEV_HOME}/.ssh/known_hosts"

install -d -o "${DEV_USER}" -g "${DEV_USER}" "${WORKSPACE_DIR}"
chown "${DEV_USER}:${DEV_USER}" "${WORKSPACE_DIR}"

run_as_dev_user() {
  sudo -u "${DEV_USER}" -H "$@"
}

verify_existing_checkout() {
  local actual_origin

  if ! run_as_dev_user git -C "${WORKSPACE_DIR}" rev-parse --is-inside-work-tree \
    >/dev/null 2>&1; then
    return 1
  fi

  actual_origin="$(run_as_dev_user git -C "${WORKSPACE_DIR}" remote get-url origin 2>/dev/null)" ||
    fail "the existing checkout does not have an origin remote"
  [[ ${actual_origin} == "${EXPECTED_ORIGIN}" ]] ||
    fail "the existing checkout origin is ${actual_origin}, expected ${EXPECTED_ORIGIN}"

  printf 'Using the existing repository checkout in %s.\n' "${WORKSPACE_DIR}"
  return 0
}

if verify_existing_checkout; then
  exit 0
fi

if [[ -n $(find "${WORKSPACE_DIR}" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  fail "${WORKSPACE_DIR} is not empty and is not a valid checkout of ${EXPECTED_ORIGIN}"
fi

CLONE_DIR="${WORKSPACE_DIR}/.devcontainer-clone-${RANDOM}-$$"
readonly CLONE_DIR

cleanup_clone_dir() {
  if [[ -d ${CLONE_DIR} && ${CLONE_DIR} == "${WORKSPACE_DIR}"/.devcontainer-clone-* ]]; then
    rm -rf -- "${CLONE_DIR}"
  fi
}
trap cleanup_clone_dir EXIT

readonly GIT_SSH_COMMAND="ssh -i ${DEV_HOME}/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${DEV_HOME}/.ssh/known_hosts"

run_as_dev_user env GIT_SSH_COMMAND="${GIT_SSH_COMMAND}" \
  git clone --branch main --single-branch "${EXPECTED_ORIGIN}" "${CLONE_DIR}"

shopt -s dotglob nullglob
clone_entries=("${CLONE_DIR}"/*)
(( ${#clone_entries[@]} > 0 )) || fail "Git produced an empty checkout"
run_as_dev_user mv -- "${clone_entries[@]}" "${WORKSPACE_DIR}/"
rmdir "${CLONE_DIR}"
trap - EXIT

verify_existing_checkout || fail "the cloned repository could not be verified"
