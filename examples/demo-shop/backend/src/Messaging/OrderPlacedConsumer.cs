using System.Threading.Tasks;
using DemoShop.Api.DataAccess;
using DemoShop.Api.Messaging.Events;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DemoShop.Api.Messaging
{
    public class OrderPlacedConsumer(
        [FromKeyedServices("orders")] IOrderRepository orders,
        ILogger<OrderPlacedConsumer> logger) : IConsumer<OrderPlacedEvent>
    {
        public async Task Consume(ConsumeContext<OrderPlacedEvent> context)
        {
            logger.LogInformation("order {OrderId} placed", context.Message.OrderId);
            await orders.MarkPlaced(context.Message.OrderId);
        }
    }
}
