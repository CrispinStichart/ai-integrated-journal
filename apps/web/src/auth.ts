import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import {
  authenticatedResponseSchema,
  authStatusResponseSchema,
  passkeyOptionsResponseSchema,
  type AuthStatusResponse,
  type AuthenticatedResponse,
} from '@journal/contracts';
import { computed, readonly, ref } from 'vue';

import { browserMetadata } from './storage/indexed-db';

interface ProblemBody {
  title?: string;
  detail?: string;
}

async function apiRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = body as ProblemBody;
    throw new Error(
      problem.detail ?? problem.title ?? 'Authentication request failed',
    );
  }
  return body;
}

const status = ref<AuthStatusResponse>();
const loading = ref(true);
const recoveryCodes = ref<readonly string[]>([]);

function applySession(session: AuthenticatedResponse): void {
  status.value = {
    bootstrapRequired: false,
    authenticated: true,
    ownerId: session.ownerId,
    displayName: session.displayName,
    csrfToken: session.csrfToken,
    sessionExpiresAt: session.sessionExpiresAt,
    passkeyCount: status.value?.passkeyCount ?? 0,
  };
}

export function useAuthentication() {
  async function initialize(): Promise<void> {
    loading.value = true;
    try {
      status.value = authStatusResponseSchema.parse(
        await apiRequest('/api/v1/auth/status'),
      );
    } finally {
      loading.value = false;
    }
  }

  async function bootstrap(input: {
    displayName: string;
    password: string;
    journalTimeZone: string;
  }): Promise<AuthenticatedResponse> {
    const session = authenticatedResponseSchema.parse(
      await apiRequest('/api/v1/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    );
    applySession(session);
    recoveryCodes.value = session.recoveryCodes ?? [];
    return session;
  }

  async function login(password: string): Promise<void> {
    const session = authenticatedResponseSchema.parse(
      await apiRequest('/api/v1/auth/password/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    );
    applySession(session);
  }

  async function recover(
    recoveryCode: string,
    newPassword: string,
  ): Promise<AuthenticatedResponse> {
    const session = authenticatedResponseSchema.parse(
      await apiRequest('/api/v1/auth/password/recover', {
        method: 'POST',
        body: JSON.stringify({ recoveryCode, newPassword }),
      }),
    );
    applySession(session);
    recoveryCodes.value = session.recoveryCodes ?? [];
    return session;
  }

  async function loginWithPasskey(): Promise<void> {
    const options = passkeyOptionsResponseSchema.parse(
      await apiRequest('/api/v1/auth/passkeys/authentication/options', {
        method: 'POST',
      }),
    );
    const credential = await startAuthentication({
      optionsJSON:
        options.options as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    const session = authenticatedResponseSchema.parse(
      await apiRequest('/api/v1/auth/passkeys/authentication/verify', {
        method: 'POST',
        body: JSON.stringify({ response: credential }),
      }),
    );
    applySession(session);
  }

  async function registerPasskey(): Promise<void> {
    const csrfToken = status.value?.csrfToken;
    if (!csrfToken) throw new Error('Your session must be refreshed');
    const options = passkeyOptionsResponseSchema.parse(
      await apiRequest('/api/v1/auth/passkeys/registration/options', {
        method: 'POST',
        headers: { 'x-csrf-token': csrfToken },
      }),
    );
    const credential = await startRegistration({
      optionsJSON:
        options.options as unknown as PublicKeyCredentialCreationOptionsJSON,
    });
    const session = authenticatedResponseSchema.parse(
      await apiRequest('/api/v1/auth/passkeys/registration/verify', {
        method: 'POST',
        headers: { 'x-csrf-token': csrfToken },
        body: JSON.stringify({ response: credential }),
      }),
    );
    applySession(session);
    if (status.value)
      status.value.passkeyCount = (status.value.passkeyCount ?? 0) + 1;
  }

  async function logout(): Promise<void> {
    const csrfToken = status.value?.csrfToken;
    if (csrfToken) {
      await apiRequest('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'x-csrf-token': csrfToken },
      });
    }
    await browserMetadata.clear();
    if ('caches' in window) {
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
    }
    status.value = {
      bootstrapRequired: false,
      authenticated: false,
    };
    recoveryCodes.value = [];
  }

  function acknowledgeRecoveryCodes(): void {
    recoveryCodes.value = [];
  }

  return {
    authenticated: computed(() => status.value?.authenticated === true),
    bootstrapRequired: computed(() => status.value?.bootstrapRequired === true),
    loading: readonly(loading),
    recoveryCodes: readonly(recoveryCodes),
    status: readonly(status),
    bootstrap,
    initialize,
    login,
    loginWithPasskey,
    logout,
    recover,
    registerPasskey,
    acknowledgeRecoveryCodes,
  };
}
