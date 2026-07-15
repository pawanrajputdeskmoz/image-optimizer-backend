const { getDashboardStats, getDashboardCards } = require("./service");
const { sendSuccess } = require("../utils/response");

exports.getDashboard = async (req, reply) => {
  const [cardsData, statsData] = await Promise.all([
    getDashboardCards(),
    getDashboardStats(),
  ]);

  return sendSuccess(reply, {
    message: "Dashboard overview",
    data: {
      cards: cardsData.cards,
      stats: {
        cards: statsData.cards,
        charts: statsData.charts,
      },
      checked_at: cardsData.checked_at,
    },
  });
};

exports.getDashboardStats = async (req, reply) => {
  const data = await getDashboardStats();
  return sendSuccess(reply, {
    message: "Dashboard stats",
    data,
  });
};

exports.getDashboardCards = async (req, reply) => {
  const data = await getDashboardCards();
  return sendSuccess(reply, {
    message: "Dashboard cards",
    data,
  });
};
