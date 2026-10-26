import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Authentication is intentionally out of scope for this challenge.
 * Replace this guard with an OIDC/JWT adapter without changing controllers.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    void context;
    return true;
  }
}
