function sendSuccess(reply, { message, data, statusCode = 200 }) {
  return reply.status(statusCode).send({
    success: true,
    message,
    data,
  });
}

function sendError(reply, { message, statusCode = 400, errors = null }) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return reply.status(statusCode).send(body);
}

module.exports = { sendSuccess, sendError };
