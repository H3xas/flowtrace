using System.Threading.Tasks;

namespace DemoShop.Api.DataAccess
{
    public interface IOrderRepository
    {
        Task<object> GetCart();
        Task UpsertCartItem(string productId, int quantity);
        Task<bool> SaveOrder(string paymentToken);
        Task MarkPlaced(string orderId);
    }

    public class OrderRepository : IOrderRepository
    {
        public Task<object> GetCart() => Task.FromResult<object>(null);

        public Task UpsertCartItem(string productId, int quantity) => Task.CompletedTask;

        public Task<bool> SaveOrder(string paymentToken) => Task.FromResult(true);

        public Task MarkPlaced(string orderId) => Task.CompletedTask;
    }
}
