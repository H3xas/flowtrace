using System.Threading.Tasks;

namespace DemoShop.Api.DataAccess
{
    public interface IProductRepository
    {
        Task<object> FindByCategory(string category);
        Task<object> GetById(string productId);
    }

    public class ProductRepository : IProductRepository
    {
        public Task<object> FindByCategory(string category) => Task.FromResult<object>(null);

        public Task<object> GetById(string productId) => Task.FromResult<object>(null);
    }
}
