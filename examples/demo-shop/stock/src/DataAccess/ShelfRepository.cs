using System.Threading.Tasks;

namespace DemoShop.Stock.DataAccess
{
    public interface IShelfRepository
    {
        Task<bool> DecrementOnHand(string productId, int quantity);
    }

    public class ShelfRepository : IShelfRepository
    {
        public Task<bool> DecrementOnHand(string productId, int quantity)
        {
            return Task.FromResult(quantity > 0);
        }
    }
}
