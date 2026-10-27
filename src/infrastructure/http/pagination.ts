export class OpaqueCursor {
  static encode(id: string): string {
    return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
  }

  static decode(cursor: string | undefined): string | undefined {
    if (!cursor) {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && value.id) {
        return value.id;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
