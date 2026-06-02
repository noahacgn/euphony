interface CopyableMessage {
  content: unknown;
}

const stringifyForCopy = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  const jsonString: unknown = JSON.stringify(value, null, 2);
  if (typeof jsonString === 'string') {
    return jsonString;
  }

  return String(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object';
};

export const getMessageCopyText = (message: CopyableMessage): string => {
  const { content } = message;
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringifyForCopy(content);
  }

  const contentItems = content as unknown[];
  const firstContent = contentItems[0];
  if (!isRecord(firstContent)) {
    return stringifyForCopy(content);
  }

  const contentType = firstContent.content_type;
  const text = firstContent.text;
  if (
    contentType === 'code' &&
    typeof text === 'string'
  ) {
    return text;
  }

  if (typeof text === 'string') {
    return text;
  }

  if ('model_identity' in firstContent || 'instructions' in firstContent) {
    return stringifyForCopy(firstContent);
  }

  return stringifyForCopy(content);
};
