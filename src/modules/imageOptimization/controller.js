

async function optimizeImage(req) {
  const body = req.body ?? {};

  return {
    ok: true,
    message: "Image optimization endpoint is running (basic stub).",
    receivedFields: body,
  };
}

module.exports = { optimizeImage };
