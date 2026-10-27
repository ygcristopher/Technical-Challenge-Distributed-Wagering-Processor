import { Injectable } from '@nestjs/common';

export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

@Injectable()
export class JsonLogger {
  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write('error', event, fields);
  }

  private write(level: string, event: string, fields: LogFields): void {
    const record = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...record });
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}
