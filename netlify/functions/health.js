exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ 
      ok: true, 
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' 
    })
  };
};
