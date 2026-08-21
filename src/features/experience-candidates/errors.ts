export type ExperienceCandidateOutputErrorKind =
  | "json_parse"
  | "schema_validation"
  | "unknown_sha";

export class ExperienceCandidateOutputError extends Error {
  readonly kind: ExperienceCandidateOutputErrorKind;
  readonly unknownShas?: readonly string[];

  constructor(
    kind: ExperienceCandidateOutputErrorKind,
    message: string,
    options?: ErrorOptions & { unknownShas?: readonly string[] }
  ) {
    super(message, options);
    this.name = "ExperienceCandidateOutputError";
    this.kind = kind;
    this.unknownShas = options?.unknownShas;
  }
}
