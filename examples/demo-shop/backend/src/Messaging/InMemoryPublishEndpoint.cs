using System.Threading.Tasks;

namespace DemoShop.Api.Messaging
{
    public class InMemoryPublishEndpoint : IPublishEndpoint
    {
        public Task Publish<T>(T message)
        {
            return Task.CompletedTask;
        }
    }
}
