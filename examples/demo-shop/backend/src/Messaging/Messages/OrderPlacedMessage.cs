namespace DemoShop.Api.Messaging.Messages
{
    public class OrderPlacedMessage : ICorrelatedMessage
    {
        public string OrderId { get; set; }
    }
}
