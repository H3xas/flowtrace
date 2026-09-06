namespace DemoShop.Api.Messaging.Events
{
    public class OrderPlacedEvent
    {
        public string OrderId { get; set; }
        public string ProductId { get; set; }
    }
}
