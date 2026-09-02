using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace DemoShop.Api.Controllers
{
    [ApiController]
    [Route("catalog/v1")]
    public class CatalogController : ControllerBase
    {
        private readonly ICatalogService _catalog;

        public CatalogController(ICatalogService catalog)
        {
            _catalog = catalog;
        }

        [HttpGet("products")]
        public async Task<IActionResult> GetProducts([FromQuery] string category)
        {
            if (string.IsNullOrEmpty(category))
            {
                return BadRequest("category is required");
            }

            var products = await _catalog.FindProducts(category);
            return Ok(products);
        }

        [HttpGet("products/{productId}")]
        public async Task<IActionResult> GetProduct(string productId)
        {
            var product = await _catalog.GetProduct(productId);
            if (product == null)
            {
                return NotFound();
            }

            return Ok(product);
        }
    }
}
