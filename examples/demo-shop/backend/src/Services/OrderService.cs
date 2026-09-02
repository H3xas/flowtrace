using System.Threading.Tasks;
using DemoShop.Api.DataAccess;
using DemoShop.Api.Messaging.Messages;

namespace DemoShop.Api.Services
{
    public interface IOrderService
    {
        Task<object> GetCart();
        Task AddItem(string productId, int quantity);
        Task<bool> PlaceOrder(string paymentToken);
    }

    public class OrderService : IOrderService
    {
        private readonly IOrderRepository _orders;
        private readonly IPublishEndpoint _bus;

        public OrderService(IOrderRepository orders, IPublishEndpoint bus)
        {
            _orders = orders;
            _bus = bus;
        }

        public async Task<object> GetCart()
        {
            return await _orders.GetCart();
        }

        public async Task AddItem(string productId, int quantity)
        {
            await _orders.UpsertCartItem(productId, quantity);
        }

        public async Task<bool> PlaceOrder(string paymentToken)
        {
            var accepted = await _orders.SaveOrder(paymentToken);
            if (!accepted)
            {
                return false;
            }

            await _bus.Publish(new OrderPlacedMessage());
            return true;
        }
    }
}
