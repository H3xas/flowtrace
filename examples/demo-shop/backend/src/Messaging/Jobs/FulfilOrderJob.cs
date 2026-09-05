namespace DemoShop.Api.Messaging.Jobs
{
    public record FulfilOrderJob(string OrderId, string ProductId);
}
