using System.Threading;
using System.Threading.Tasks;
using DemoShop.Api.Messaging;
using DemoShop.Api.Messaging.Messages;
using DemoShop.Api.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace DemoShop.Api.Endpoints
{
    public class ReplayRequest
    {
        public string OrderId { get; set; }
    }

    public static class ReplayEndpoints
    {
        public static void MapReplayEndpoints(this IEndpointRouteBuilder app)
        {
            app.MapPost("orders/v1/replay", async (ReplayRequest request, IOrderReplayService replays, IPublishEndpoint bus, CancellationToken cancellationToken) =>
            {
                if (request == null || string.IsNullOrEmpty(request.OrderId))
                {
                    return Results.BadRequest("orderId is required");
                }

                var recorded = await replays.RecordReplay(request.OrderId);
                if (!recorded)
                {
                    return Results.NotFound();
                }

                await bus.Publish(new FulfilOrderJob { OrderId = request.OrderId });
                return Results.Accepted();
            });
        }
    }
}
