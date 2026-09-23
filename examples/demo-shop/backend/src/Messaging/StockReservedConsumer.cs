using System.Threading.Tasks;
using DemoShop.Stock.Messaging.Events;
using Microsoft.Extensions.Logging;

namespace DemoShop.Api.Messaging
{
    public class StockReservedConsumer(ILogger<StockReservedConsumer> logger) : IConsumer<StockReservedEvent>
    {
        public Task Consume(ConsumeContext<StockReservedEvent> context)
        {
            logger.LogInformation("stock reserved for {ProductId}", context.Message.ProductId);
            return Task.CompletedTask;
        }
    }
}
