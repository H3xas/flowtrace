using System.Threading.Tasks;
using DemoShop.Api.Messaging.Jobs;
using DemoShop.Api.Services;

namespace DemoShop.Api.Messaging
{
    public class FulfilOrderJobConsumer : IJobConsumer<FulfilOrderJob>
    {
        private readonly IFulfilmentHandler _handler;

        public FulfilOrderJobConsumer(IFulfilmentHandler handler)
        {
            _handler = handler;
        }

        public Task Run(JobContext<FulfilOrderJob> context)
        {
            return _handler.Fulfil(context.Job.OrderId);
        }
    }
}
