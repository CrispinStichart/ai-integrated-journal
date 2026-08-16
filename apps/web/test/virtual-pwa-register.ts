export interface RegisterSwOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
}

export function registerSW(
  _options: RegisterSwOptions,
): (reloadPage?: boolean) => Promise<void> {
  void _options;
  return async () => undefined;
}
