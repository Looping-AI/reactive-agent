/** JSON values safe to persist and pass over Durable Object RPC. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Metadata-free text in the caller's conversation. */
export interface ConversationTextPart {
  kind: "text";
  text: string;
}

/** Metadata-free file source represented by base64-encoded bytes. */
export interface ConversationFileBytes {
  bytes: string;
  mimeType?: string;
  name?: string;
}

/** Metadata-free file source represented by a URI. */
export interface ConversationFileUri {
  uri: string;
  mimeType?: string;
  name?: string;
}

/** Metadata-free file in the caller's conversation. */
export interface ConversationFilePart {
  kind: "file";
  file: ConversationFileBytes | ConversationFileUri;
}

/** Metadata-free structured data in the caller's conversation. */
export interface ConversationDataPart {
  kind: "data";
  data: { [key: string]: JsonValue };
}

/** A serializable original or generated conversation part. */
export type ConversationPart =
  ConversationTextPart | ConversationFilePart | ConversationDataPart;
