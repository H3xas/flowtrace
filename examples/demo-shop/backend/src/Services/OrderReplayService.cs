using System.Threading.Tasks;
using DemoShop.Api.DataAccess;

namespace DemoShop.Api.Services
{
    public interface IOrderReplayService
    {
        Task<bool> RecordReplay(string orderId);
    }

    public class OrderReplayService : IOrderReplayService
    {
        private readonly IOrderRepository _orders;

        public OrderReplayService(IOrderRepository orders)
        {
            _orders = orders;
        }

        public async Task<bool> RecordReplay(string orderId)
        {
            var order = await _orders.FindOrder(orderId);
            if (order == null)
            {
                return false;
            }

            await _orders.SaveReplay(orderId);
            return true;
        }
    }
}
