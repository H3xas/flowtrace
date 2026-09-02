using System.Threading.Tasks;
using DemoShop.Api.DataAccess;

namespace DemoShop.Api.Services
{
    public interface ICatalogService
    {
        Task<object> FindProducts(string category);
        Task<object> GetProduct(string productId);
    }

    public class CatalogService : ICatalogService
    {
        private readonly IProductRepository _products;

        public CatalogService(IProductRepository products)
        {
            _products = products;
        }

        public async Task<object> FindProducts(string category)
        {
            return await _products.FindByCategory(category);
        }

        public async Task<object> GetProduct(string productId)
        {
            return await _products.GetById(productId);
        }
    }
}
