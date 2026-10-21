// Git over HTTPS with an installation token (T-084). The token travels only in the env of the call: argv carries
// the name of the variable, and the credential helper reads it from its env. A reset of credential.helper first
// keeps any helper of the host (the keychain, for one) out of the way.
export const GIT_TOKEN_ENV = "SHOALWORK_GIT_TOKEN"

export const GIT_CREDENTIAL_ARGV: ReadonlyArray<string> = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { echo username=x-access-token; echo "password=$SHOALWORK_GIT_TOKEN"; }; f',
]

// The context of one git call, with the token in both places a Tank reads from: env (local mode) and stepEnv
// (the server mode's sudo --preserve-env). Returns a new context; the original is untouched.
export const withGitToken = <
  C extends {
    readonly env: Readonly<Record<string, string>>
    readonly stepEnv?: Readonly<Record<string, string>>
  },
>(
  ctx: C,
  token: string,
): C => ({
  ...ctx,
  env: { ...ctx.env, [GIT_TOKEN_ENV]: token },
  stepEnv: { ...ctx.stepEnv, [GIT_TOKEN_ENV]: token },
})
