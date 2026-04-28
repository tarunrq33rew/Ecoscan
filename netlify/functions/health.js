exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      model: process.env.NVIDIA_MODEL || 'meta/llama-3.2-90b-vision-instruct'
    })
  };
};
