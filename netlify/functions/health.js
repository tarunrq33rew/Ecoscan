exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      model: process.env.NVIDIA_MODEL || 'google/gemma-4-31b-it'
    })
  };
};
