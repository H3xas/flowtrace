using System;
using System.Threading.Tasks;
using DemoShop.Api.DataAccess;

namespace DemoShop.Api.Services
{
    public interface IFulfilmentHandler
    {
        Task Fulfil(string orderId);
    }

    public class FulfilmentHandler : IFulfilmentHandler
    {
        private readonly IOrderRepository _orders;

        public FulfilmentHandler(IOrderRepository orders)
        {
            _orders = orders;
        }

        public async Task Fulfil(string orderId)
        {
            var order = await _orders.FindOrder(orderId);
            if (order == null)
            {
                throw new InvalidOperationException("order not found");
            }

            await _orders.SaveFulfilment(orderId);
        }
    }
}
