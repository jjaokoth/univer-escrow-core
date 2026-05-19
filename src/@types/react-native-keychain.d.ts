declare module "react-native-keychain" {
  export function setGenericPassword(
    username: string,
    password: string,
    options?: { service?: string }
  ): Promise<void>;

  export function getGenericPassword(options?: { service?: string }): Promise<
    | { password?: string } | null
    | undefined
  >;

  export function resetGenericPassword(options?: { service?: string }): Promise<void>;

  const _default: {
    setGenericPassword: typeof setGenericPassword;
    getGenericPassword: typeof getGenericPassword;
    resetGenericPassword: typeof resetGenericPassword;
  };

  export default _default;
}

