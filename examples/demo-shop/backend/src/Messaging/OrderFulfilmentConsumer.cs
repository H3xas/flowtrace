using System.Threading.Tasks;
using DemoShop.Api.DataAccess;
using DemoShop.Api.Messaging.Jobs;
using Microsoft.Extensions.Logging;

namespace DemoShop.Api.Messaging
{
    public class OrderFulfilmentConsumer(
        IProductRepository products,
        ILogger<OrderFulfilmentConsumer> logger) : IConsumer<FulfilOrderJob>
    {
        public async Task Consume(ConsumeContext<FulfilOrderJob> context)
        {
            var product = await products.GetById(context.Message.ProductId);
            logger.LogInformation("fulfilling order {OrderId} with {Product}", context.Message.OrderId, product);
        }
    }
}
