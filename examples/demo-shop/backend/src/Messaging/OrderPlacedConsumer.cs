using System.Threading.Tasks;
using DemoShop.Api.Messaging.Messages;

namespace DemoShop.Api.Messaging
{
    public class OrderPlacedConsumer : IConsumer<OrderPlacedMessage>
    {
        public Task Consume(ConsumeContext<OrderPlacedMessage> context) => Task.CompletedTask;
    }
}
