<script setup lang="ts">
import { computed, ref } from 'vue';

import { useAuthentication } from '../auth';

const auth = useAuthentication();
const mode = ref<'login' | 'recovery'>('login');
const displayName = ref('Owner');
const password = ref('');
const recoveryCode = ref('');
const error = ref('');
const submitting = ref(false);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const heading = computed(() =>
  auth.bootstrapRequired.value
    ? 'Create your private journal'
    : 'Unlock your journal',
);

async function submit(): Promise<void> {
  error.value = '';
  submitting.value = true;
  try {
    if (auth.bootstrapRequired.value) {
      await auth.bootstrap({
        displayName: displayName.value,
        password: password.value,
        journalTimeZone: timeZone,
      });
    } else if (mode.value === 'recovery') {
      await auth.recover(recoveryCode.value, password.value);
    } else {
      await auth.login(password.value);
    }
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Authentication failed';
  } finally {
    submitting.value = false;
  }
}

async function usePasskey(): Promise<void> {
  error.value = '';
  submitting.value = true;
  try {
    await auth.loginWithPasskey();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Passkey authentication failed';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main
    class="grid min-h-screen place-items-center bg-base-200 px-4 py-10 text-base-content"
  >
    <section
      class="card card-border w-full max-w-md bg-base-100 shadow-sm"
      aria-labelledby="auth-heading"
    >
      <div class="card-body gap-5">
        <div>
          <p class="mb-2 text-sm font-medium text-base-content/60">
            Private by default
          </p>
          <h1 id="auth-heading" class="card-title text-2xl">{{ heading }}</h1>
          <p class="mt-2 text-sm text-base-content/70">
            {{
              auth.bootstrapRequired.value
                ? 'Your password is stored only as a strong Argon2id hash.'
                : 'Use your passkey or recovery password to continue.'
            }}
          </p>
        </div>

        <div v-if="error" role="alert" class="alert alert-error alert-soft">
          <span>{{ error }}</span>
        </div>

        <div
          v-if="auth.recoveryCodes.value.length"
          role="alert"
          class="alert alert-warning alert-soft"
        >
          <div>
            <h2 class="font-semibold">
              Save these one-time recovery codes now
            </h2>
            <p class="mt-1 text-sm">
              They cannot be shown again. Each code works once.
            </p>
            <ul class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
              <li v-for="code in auth.recoveryCodes.value" :key="code">
                {{ code }}
              </li>
            </ul>
            <button
              class="btn mt-4 w-full"
              type="button"
              @click="auth.acknowledgeRecoveryCodes"
            >
              I’ve saved these codes
            </button>
          </div>
        </div>

        <form v-else class="space-y-4" @submit.prevent="submit">
          <fieldset v-if="auth.bootstrapRequired.value" class="fieldset">
            <legend class="fieldset-legend">Display name</legend>
            <input
              v-model="displayName"
              class="input w-full"
              autocomplete="name"
              required
            />
          </fieldset>

          <fieldset v-if="mode === 'recovery'" class="fieldset">
            <legend class="fieldset-legend">Recovery code</legend>
            <input
              v-model="recoveryCode"
              class="input w-full font-mono uppercase"
              autocomplete="one-time-code"
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              required
            />
          </fieldset>

          <fieldset class="fieldset">
            <legend class="fieldset-legend">
              {{ mode === 'recovery' ? 'New password' : 'Password' }}
            </legend>
            <input
              v-model="password"
              type="password"
              class="input w-full"
              :autocomplete="
                auth.bootstrapRequired.value || mode === 'recovery'
                  ? 'new-password'
                  : 'current-password'
              "
              :minlength="
                auth.bootstrapRequired.value || mode === 'recovery' ? 12 : 1
              "
              required
            />
            <p
              v-if="auth.bootstrapRequired.value || mode === 'recovery'"
              class="label"
            >
              Use at least 12 characters.
            </p>
          </fieldset>

          <button
            class="btn btn-primary btn-block"
            type="submit"
            :disabled="submitting"
          >
            <span
              v-if="submitting"
              class="loading loading-spinner loading-sm"
              aria-hidden="true"
            />
            {{
              auth.bootstrapRequired.value
                ? 'Create journal'
                : mode === 'recovery'
                  ? 'Recover account'
                  : 'Sign in'
            }}
          </button>
        </form>

        <template
          v-if="
            !auth.bootstrapRequired.value && !auth.recoveryCodes.value.length
          "
        >
          <button
            class="btn btn-block"
            type="button"
            :disabled="submitting"
            @click="usePasskey"
          >
            Sign in with a passkey
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            @click="mode = mode === 'login' ? 'recovery' : 'login'"
          >
            {{
              mode === 'login'
                ? 'Use a recovery code'
                : 'Back to password sign-in'
            }}
          </button>
        </template>
      </div>
    </section>
  </main>
</template>
