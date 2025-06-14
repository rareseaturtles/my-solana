const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;

exports.handler = async (event) => {
  try {
    const { wallet } = JSON.parse(event.body) || {};
    if (!wallet) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing wallet in request body" })
      };
    }
    const isAdmin = wallet.toLowerCase() === ADMIN_WALLET.toLowerCase();
    return {
      statusCode: 200,
      body: JSON.stringify({ isAdmin })
    };
  } catch (error) {
    console.error("Error in check-admin:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
