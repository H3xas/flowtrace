using System.Threading.Tasks;
using DemoShop.Api.DataAccess;
using DemoShop.Api.Messaging.Messages;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DemoShop.Api.Messaging
{
    public class OrderPlacedConsumer(
        [FromKeyedServices("orders")] IOrderRepository orders,
        ILogger<OrderPlacedConsumer> logger) : IConsumer<OrderPlacedMessage>
    {
        public async Task Consume(ConsumeContext<OrderPlacedMessage> context)
        {
            logger.LogInformation("order {OrderId} placed", context.Message.OrderId);
            await orders.MarkPlaced(context.Message.OrderId);
        }
    }
}
