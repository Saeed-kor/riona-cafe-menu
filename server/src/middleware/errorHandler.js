export function errorHandler(error, _request, response, next) {
  if (response.headersSent) {
    return next(error);
  }

  const status =
    Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;

  console.error('Unhandled request error.', {
    name: error?.name ?? 'Error',
    code: error?.code ?? 'UNKNOWN_ERROR',
  });

  return response.status(status).json({
    success: false,
    message: status === 500 ? 'Internal server error' : 'Request could not be processed',
  });
}
