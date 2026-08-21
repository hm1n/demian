export type ExperienceCandidateOutputErrorKind =
  | "json_parse"
  | "schema_validation"
  | "unknown_sha"
  | "unrelated_sha"
  | "unknown_file_path";

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
