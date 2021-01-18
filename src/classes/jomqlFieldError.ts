import { JomqlBaseError } from ".";
export class JomqlFieldError extends JomqlBaseError {
  constructor(params: { message: string; fieldPath: string[] }) {
    const { message, fieldPath } = params;
    super({
      errorName: "JomqlFieldError",
      message,
      fieldPath,
      statusCode: 400,
    });
  }
}
