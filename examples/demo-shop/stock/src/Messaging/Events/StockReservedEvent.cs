namespace DemoShop.Stock.Messaging.Events
{
    public class StockReservedEvent
    {
        public string ProductId { get; set; }
        public int Quantity { get; set; }
    }
}
