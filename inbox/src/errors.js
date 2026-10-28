export class InboxPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "InboxPathError";
    this.status = 400;
  }
}

export class AuthError extends Error {
  constructor(message = "未授权") {
    super(message);
    this.name = "AuthError";
    this.status = 401;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.status = 404;
  }
}
